import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BUILTIN_AGENTS, discoverAgents } from "../src/agents.ts";
import { DEFAULT_TIER_DESCRIPTIONS, pickQuestions, resolve } from "../src/pick.ts";

let root: string;
let user: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pi-agent-defaults-"));
  user = path.join(root, "user");
  project = path.join(root, "project");
  mkdirSync(path.join(user, "agents"), { recursive: true });
  mkdirSync(project);
  vi.stubEnv("PI_CODING_AGENT_DIR", user);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const tiers = { models: {}, descriptions: DEFAULT_TIER_DESCRIPTIONS };
const parent = { model: "provider/model", thinking: "medium" };

const ROLES = ["general", "explorer", "worker", "reviewer", "researcher", "writer", "planner"];

test("ships seven roles with per-provider fallback profiles and provider-independent fallback effort", () => {
  const agents = discoverAgents(project);
  expect(agents.map((agent) => agent.name)).toEqual(ROLES);
  expect(agents).toEqual(BUILTIN_AGENTS);
  const profiles = Object.fromEntries(agents.map((a) => [a.name, a.models && Object.fromEntries(Object.entries(a.models).map(([provider, entry]) => [provider, `${entry.model}:${entry.thinking}`]))]));
  const baseline = (anthropic: string, openai: string, google: string, muse: string, effort: string) => ({
    anthropic: `anthropic/${anthropic}:${effort}`,
    openai: `openai/${openai}:${effort}`,
    "openai-codex": `openai-codex/${openai}:${effort}`,
    google: `google/${google}:${effort}`,
    "muse-code": `muse-code/${muse}:${effort}`,
  });
  expect(profiles).toEqual({
    general: undefined,
    explorer: { ...baseline("claude-sonnet-5-5", "gpt-6-luna", "gemini-3.8-flash", "muse-spark-1.3", "low"), openai: "openai/gpt-6-luna:high", "openai-codex": "openai-codex/gpt-6-luna:high" },
    worker: baseline("claude-sonnet-5-5", "gpt-6.1-terra", "gemini-3.8-flash", "muse-spark-1.3", "medium"),
    reviewer: baseline("claude-opus-5-5", "gpt-6.1-sol", "gemini-4-argon", "muse-wonder-1.0", "high"),
    researcher: baseline("claude-sonnet-5-5", "gpt-6.1-terra", "gemini-3.8-flash", "muse-spark-1.3", "medium"),
    writer: baseline("claude-sonnet-5-5", "gpt-6.1-terra", "gemini-3.8-flash", "muse-spark-1.3", "medium"),
    planner: baseline("claude-opus-5-5", "gpt-6.1-sol", "gemini-4-argon", "muse-wonder-1.0", "high"),
  });
  for (const agent of agents) {
    expect(agent.source).toBe("builtin");
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBe(agent.name === "general" ? undefined : ["explorer"].includes(agent.name) ? "low" : ["reviewer", "planner"].includes(agent.name) ? "high" : "medium");
    // No known hierarchy on this provider: retain the parent model visibly, not its effort.
    expect(resolve({ agent: agent.name }, agents, undefined, tiers, parent)).toMatchObject({ model: parent.model, thinking: agent.thinking ?? "medium", source: { model: "default", thinking: agent.thinking ? "profile" : "default" }, note: "parent fallback: no usable role or tier mapping for provider" });
    if (agent.name !== "general") expect(agent.prompt).toMatch(/^You are an? /u);
  }
  expect(agents.find((a) => a.name === "researcher")?.tools).toBeUndefined();
  for (const name of ["explorer", "reviewer", "planner"]) {
    const agent = agents.find((a) => a.name === name)!;
    expect(agent.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(agent.prompt).toContain("Do not implement");
    expect(agent.prompt).toContain("not a filesystem sandbox");
  }
  expect(pickQuestions({}, agents, tiers, false).role).toMatchObject({
    criteria: Object.fromEntries(agents.map((agent) => [agent.name, agent.description])),
  });
  expect(resolve({}, agents, undefined, tiers, parent)).toMatchObject({ agent: { name: "general" } });
});

test("user roles override built-ins and nearest project roles override user roles", () => {
  writeFileSync(path.join(user, "agents", "explorer.md"), "---\nname: explorer\ndescription: User explorer\nmodel: user/model\n---\nUser prompt");
  expect(discoverAgents(project).find((agent) => agent.name === "explorer")).toMatchObject({ source: "user", model: "user/model", prompt: "User prompt" });
  const projectAgents = path.join(project, ".pi", "agents");
  mkdirSync(projectAgents, { recursive: true });
  writeFileSync(path.join(projectAgents, "explorer.md"), "---\nname: explorer\ndescription: Project explorer\n---\nProject prompt");
  const nested = path.join(project, "src", "nested");
  mkdirSync(nested, { recursive: true });
  const agents = discoverAgents(nested);
  expect(agents.map((agent) => agent.name)).toEqual(ROLES);
  expect(agents.find((agent) => agent.name === "explorer")).toMatchObject({ source: "project", prompt: "Project prompt" });
  expect(agents.find((agent) => agent.name === "explorer")?.model).toBeUndefined();
  // An override replaces the built-in whole, profile included.
  expect(agents.find((agent) => agent.name === "explorer")?.models).toBeUndefined();
});

test("edit roles get a fixed lean tool list; researcher keeps the defaults", () => {
  const edit = ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "bg_run", "bg_wait", "bg_logs", "bg_kill"];
  const by = (name: string) => BUILTIN_AGENTS.find((agent) => agent.name === name);
  for (const name of ["worker", "general", "writer"]) expect(by(name)?.tools).toEqual(edit);
  expect(by("researcher")?.tools).toBeUndefined();
});
