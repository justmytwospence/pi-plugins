import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import toolGate, { DECLINED } from "../src/index.ts";
import { fakeJev, harness } from "./harness.ts";

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "pi-tool-gate-project-policy-"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(configDir, "xdg"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(configDir, "pi"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

// Matches the blog project's policy supplied by the parent task; no live project dependency.
const blogPolicy = {
  directories: { read: ["*"], write: [] },
  permissions: {
    allow: ["Bash(vercel deploy *)"],
    ask: [
      "Bash(*vercel*--prod*)",
      "Bash(*vercel*--target*production*)",
      "Bash(*vercel* promote*)",
      "Bash(*vercel* rollback*)",
      "Bash(*vercel* alias*)",
      "Bash(*vercel* redeploy*)",
      "Bash(git push *)",
      "Bash(gh pr merge *)",
      "Bash(*vercel* env*)",
      "Bash(*vercel* project*)",
      "Bash(*vercel* domains*)",
      "Bash(*vercel* api*)",
      "mcp__vercel",
    ],
  },
};

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const call = (toolName: string, input: Record<string, unknown>, id = "t1") => ({ type: "tool_call", toolCallId: id, toolName, input });

function actualGit(cwd: string) {
  const h = harness({ exec: (cmd, args) => {
    // Only repository discovery executes; matrix commands remain fake tool-call events.
    if (cmd !== "git" && !(cmd === "env" && JSON.stringify(args) === JSON.stringify([
      "LC_ALL=C", "git", "-C", cwd, "rev-parse", "--show-toplevel",
    ]))) throw new Error(`Unexpected executable: ${cmd}`);
    try { return { code: 0, stdout: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
    catch { return { code: 1, stdout: "", stderr: "" }; }
  } });
  toolGate(h.pi);
  const jev = fakeJev(() => { throw new Error("Project policy must decide without classification"); });
  return { h, jev, ctx: h.ctx({ cwd, modelRegistry: jev.registry }) };
}

test("deployment policy allows previews but asks for production and publishing from root and components", async () => {
  const root = realpathSync(configDir);
  git(root, "init", "-q");
  const nested = path.join(root, "components");
  mkdirSync(nested);
  mkdirSync(path.join(root, ".pi"));
  writeFileSync(path.join(root, ".pi", "tool-gate.json"), JSON.stringify(blogPolicy));
  const asks = [
    "vercel deploy --prod",
    "vercel --prod deploy",
    "vercel deploy --target production",
    "vercel --target production deploy",
    "vercel deploy --target=production",
    "vercel --target=production deploy",
    "env CI=1 vercel deploy --prod",
    "npx vercel deploy --target=production",
    "bash -c 'vercel deploy --prod'",
    "echo $(vercel deploy --target production)",
    "vercel deploy --prebuilt && vercel deploy --prod",
    "vercel promote preview.example.com",
    "vercel rollback deployment-id",
    "vercel alias set preview.example.com production.example.com",
    "vercel redeploy deployment-id",
    "git push",
    "git push origin main",
    "gh pr merge 123 --merge",
    "vercel env pull",
    "vercel project ls",
    "vercel domains ls",
    "vercel api /v9/projects",
  ];
  for (const cwd of [root, nested]) {
    const s = actualGit(cwd);
    await s.h.emit("session_start", {}, s.ctx);
    // These are decision events in the fake harness, never shell executions.
    expect(await s.h.emit("tool_call", call("bash", { command: "vercel deploy" }), s.ctx), cwd).toBeUndefined();
    expect(await s.h.emit("tool_call", call("bash", { command: "vercel deploy --target preview" }), s.ctx), cwd).toBeUndefined();
    expect(s.ctx.ui.selects, cwd).toHaveLength(0);
    const calls = [
      ...asks.map((command) => call("bash", { command }, command)),
      call("mcp__vercel__deploy_to_vercel", {}, "mcp-deploy"),
    ];
    for (const event of calls) {
      const label = `${cwd}: ${event.toolCallId}`;
      const before = s.ctx.ui.selects.length;
      s.ctx.ui.selectAnswers.push("Block");
      expect(await s.h.emit("tool_call", event, s.ctx), label).toMatchObject({ block: true, reason: DECLINED });
      expect(s.ctx.ui.selects, label).toHaveLength(before + 1);
      expect(s.ctx.ui.selects.at(-1)?.title, label).toContain("matches the ask rule");
    }
    expect(s.jev.calls, cwd).toHaveLength(0);
  }
});
