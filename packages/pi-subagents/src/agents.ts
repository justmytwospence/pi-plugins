import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./config.ts";

/** A role's model on one provider: `provider/id`, with an optional fixed thinking level. */
export interface ProfileModel {
  model: string;
  thinking?: string;
}

export interface AgentDef {
  name: string;
  description: string;
  /** Tool names for the child (`--tools`); undefined keeps Pi's defaults. */
  tools?: string[];
  /** `provider/model` or a model pattern Pi resolves. */
  model?: string;
  /**
   * The role's model per provider (frontmatter `models:`, `provider: provider/id[:thinking]`): an
   * implicit pick on a parent of that provider uses it; other providers fall back to the tier rules.
   */
  models?: Record<string, ProfileModel>;
  thinking?: string;
  /** Turns before the agent is told to wrap up; one turn later it is stopped. */
  maxTurns?: number;
  /** Appended to the child's system prompt. */
  prompt: string;
  source: "builtin" | "user" | "project";
  file?: string;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
const NO_CHANGES = "Do not implement fixes or modify files. Use bash only for inspection, never for commands that change files or repository state. Your no-change policy is an instruction, not a filesystem sandbox.";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const profile = (anthropic: string, anthropicThinking: string, codex: string, codexThinking: string): Record<string, ProfileModel> => ({
  anthropic: { model: anthropic, thinking: anthropicThinking },
  "openai-codex": { model: codex, thinking: codexThinking },
});

export const GENERAL: AgentDef = {
  name: "general",
  description: "Anything no other role fits: open-ended or mixed work, quick questions and explanations, small tasks that combine reading, editing and running commands",
  prompt: "",
  source: "builtin",
};

export const EXPLORER: AgentDef = {
  name: "explorer",
  description: "Read-only recon of a codebase: find files, symbols and call sites, trace how something works, and report findings with file and line references, without editing",
  tools: [...READ_ONLY_TOOLS],
  models: profile(SONNET, "low", "openai-codex/gpt-6-luna", "high"),
  prompt: `You are a codebase explorer. Locate the relevant files and symbols, trace actual behavior, and return concise findings with file paths and line references. Distinguish evidence from assumptions and identify anything unresolved. ${NO_CHANGES}`,
  source: "builtin",
};

export const WORKER: AgentDef = {
  name: "worker",
  description: "Implement a clearly specified change: edit code, apply a decided change across files, write tests to a given spec, run checks and fix what fails",
  models: profile(SONNET, "medium", "openai-codex/gpt-6.1-sol", "medium"),
  prompt: "You are an implementation worker. Carry out the specified change completely and within its scope: edit the files, follow the repository's conventions, and run the relevant checks and tests, fixing what fails. Do not widen the scope or redesign beyond the spec; when the spec is ambiguous or a decision is needed, stop and report the blocker instead of guessing. Report the files you changed with a brief summary, the checks you ran and their results, and anything left unresolved.",
  source: "builtin",
};

export const REVIEWER: AgentDef = {
  name: "reviewer",
  description: "Independent review of a diff, branch or change for bugs, regressions, security risks and missing tests; reports evidence without fixing anything",
  tools: [...READ_ONLY_TOOLS],
  models: profile(OPUS, "high", "openai-codex/gpt-6.1-sol", "high"),
  prompt: `You are an independent code reviewer. Inspect the requested changes and surrounding execution paths for actionable bugs, regressions, security risks, and missing tests. Prioritize concrete correctness issues over stylistic preferences. For each finding, give severity, a file and line reference, the failing scenario, and supporting evidence. Distinguish confirmed issues from uncertainty; say explicitly when no actionable issues were found. ${NO_CHANGES}`,
  source: "builtin",
};

export const RESEARCHER: AgentDef = {
  name: "researcher",
  description: "Research outside the codebase: search the web and documentation about libraries, APIs, versions, tools and vendor guidance, and answer with sources",
  models: profile(SONNET, "medium", "openai-codex/gpt-6.1-terra", "medium"),
  prompt: "You are a researcher. Answer the question from primary sources: official documentation, source code, release notes and vendor pages, preferring current ones. Cite a URL or file path for every claim, give versions and dates where they matter, and distinguish confirmed facts from inference and from conflicting sources. Do not modify the repository unless the task asks for it. Give a concise answer first, then the evidence.",
  source: "builtin",
};

export const WRITER: AgentDef = {
  name: "writer",
  description: "Produce or rewrite a written document: documentation, READMEs, changelogs, reports, summaries of documents or code and other write-ups (not for explaining a concept or answering a question)",
  models: profile(SONNET, "medium", "openai-codex/gpt-6.1-terra", "medium"),
  prompt: "You are a writer. Produce the requested text (documentation, a summary, a report or another write-up) for its stated audience: accurate, concise, and in the style of the surrounding documents. Check facts against the code or sources instead of inventing them, and mark anything you could not verify. Edit only the files the task names; return the text, or a summary of your changes when you edited files.",
  source: "builtin",
};

export const PLANNER: AgentDef = {
  name: "planner",
  description: "Design and hard analysis without edits: write an implementation plan, weigh approaches, trade-offs and risks, or work out a subtle problem before anyone changes code",
  tools: [...READ_ONLY_TOOLS],
  models: profile(OPUS, "high", "openai-codex/gpt-6.1-sol", "high"),
  prompt: `You are a planner. Read the relevant code, weigh the alternatives and their trade-offs, and return the recommended approach as concrete steps with the files involved, the risks, and how to verify each step. Distinguish evidence from assumptions and list open questions. Do not implement the plan. ${NO_CHANGES}`,
  source: "builtin",
};

export const BUILTIN_AGENTS: readonly AgentDef[] = [GENERAL, EXPLORER, WORKER, REVIEWER, RESEARCHER, WRITER, PLANNER];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING = new Set<string>(THINKING_LEVELS);

function list(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const items = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * Frontmatter `models:`: `provider: provider/id`, optionally `:thinking` (a thinking level), or a
 * bare id taken as the key's provider. Entries naming another provider than their key are dropped.
 */
export function parseModels(value: unknown): Record<string, ProfileModel> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const models: Record<string, ProfileModel> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const provider = key.trim();
    if (!provider || typeof raw !== "string" || !raw.trim()) continue;
    let spec = raw.trim();
    let thinking: string | undefined;
    const colon = spec.lastIndexOf(":");
    if (colon > 0 && THINKING.has(spec.slice(colon + 1))) {
      thinking = spec.slice(colon + 1);
      spec = spec.slice(0, colon);
    }
    const model = spec.includes("/") ? spec : `${provider}/${spec}`;
    if (!model.startsWith(`${provider}/`) || model.length === provider.length + 1) continue;
    models[provider] = { model, ...(thinking ? { thinking } : {}) };
  }
  return Object.keys(models).length ? models : undefined;
}

export function parseAgent(content: string, source: AgentDef["source"], file?: string): AgentDef | undefined {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch {
    return undefined;
  }
  const fm = parsed.frontmatter;
  if (typeof fm.name !== "string" || typeof fm.description !== "string") return undefined;
  const tools = list(fm.tools);
  const models = parseModels(fm.models);
  const turns = Number(fm.maxTurns ?? fm.max_turns);
  const maxTurns = Number.isInteger(turns) && turns > 0 ? turns : undefined;
  return {
    name: fm.name.trim(),
    description: fm.description.trim(),
    ...(tools ? { tools } : {}),
    ...(typeof fm.model === "string" && fm.model.trim() ? { model: fm.model.trim() } : {}),
    ...(models ? { models } : {}),
    ...(typeof fm.thinking === "string" && THINKING.has(fm.thinking.trim()) ? { thinking: fm.thinking.trim() } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    prompt: parsed.body.trim(),
    source,
    ...(file ? { file } : {}),
  };
}

function loadDir(dir: string, source: "user" | "project"): AgentDef[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name);
    try {
      const agent = parseAgent(readFileSync(file, "utf8"), source, file);
      return agent ? [agent] : [];
    } catch {
      return [];
    }
  });
}

function projectAgentsDir(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, ".pi", "agents");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Built-ins, then `~/.pi/agent/agents/*.md`, then the nearest `<repo>/.pi/agents/*.md`; later names win. */
export function discoverAgents(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>(BUILTIN_AGENTS.map((agent) => [agent.name, agent]));
  for (const agent of loadDir(path.join(agentDir(), "agents"), "user")) byName.set(agent.name, agent);
  const project = projectAgentsDir(cwd);
  if (project) for (const agent of loadDir(project, "project")) byName.set(agent.name, agent);
  return [...byName.values()];
}
