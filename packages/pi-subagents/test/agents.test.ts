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

test("ships seven roles: general without a profile, the others with Anthropic and Codex models and fixed efforts", () => {
  const agents = discoverAgents(project);
  expect(agents.map((agent) => agent.name)).toEqual(ROLES);
  expect(agents).toEqual(BUILTIN_AGENTS);
  const profiles = Object.fromEntries(agents.map((a) => [a.name, a.models && { anthropic: `${a.models.anthropic?.model}:${a.models.anthropic?.thinking}`, codex: `${a.models["openai-codex"]?.model}:${a.models["openai-codex"]?.thinking}` }]));
  expect(profiles).toEqual({
    general: undefined,
    explorer: { anthropic: "anthropic/claude-sonnet-5-5:low", codex: "openai-codex/gpt-6-luna:high" },
    worker: { anthropic: "anthropic/claude-sonnet-5-5:medium", codex: "openai-codex/gpt-6.1-sol:medium" },
    reviewer: { anthropic: "anthropic/claude-opus-5-5:high", codex: "openai-codex/gpt-6.1-sol:high" },
    researcher: { anthropic: "anthropic/claude-sonnet-5-5:medium", codex: "openai-codex/gpt-6.1-terra:medium" },
    writer: { anthropic: "anthropic/claude-sonnet-5-5:medium", codex: "openai-codex/gpt-6.1-terra:medium" },
    planner: { anthropic: "anthropic/claude-opus-5-5:high", codex: "openai-codex/gpt-6.1-sol:high" },
  });
  for (const agent of agents) {
    expect(agent.source).toBe("builtin");
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    // No profile for this provider: the tier rules, here the parent's model and thinking.
    expect(resolve({ agent: agent.name }, agents, undefined, tiers, parent)).toMatchObject(parent);
    if (agent.name !== "general") expect(agent.prompt).toMatch(/^You are an? /u);
  }
  for (const name of ["general", "worker", "researcher", "writer"]) expect(agents.find((a) => a.name === name)?.tools).toBeUndefined();
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
