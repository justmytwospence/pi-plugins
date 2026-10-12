// `@subagent:<name>` in the prompt: pi's own autocomplete lists the discovered agents (the built-in
// roles and `~/.pi/agent/agents/*.md`, `<project>/.pi/agents/*.md`) after `@subagent:`, and a
// prompt that mentions one gets a hidden message telling the model to delegate to that agent with
// the `subagent` tool. The convention is this extension's, not Claude Code's `@agent-name`: a
// mention never starts a run by itself, and nothing here needs any other tool installed.
import type { AgentDef } from "./agents.ts";

export const MENTION_TYPE = "subagent-mention";
const PREFIX = "@subagent:";
/** A mention token at the cursor: `@subagent:` and whatever name follows, wrapped in prose or not. */
const AT_CURSOR = /(?:^|[\s([{<`"'])(@subagent:[A-Za-z0-9_.-]*)$/u;
/** Mentions anywhere in a prompt. */
const MENTIONS = /(?:^|[\s([{<`"'])@subagent:([A-Za-z0-9_.-]+)/gu;

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

/** The part of pi's `AutocompleteProvider` a wrapper needs (structural, so tests need no pi-tui). */
export interface AutocompleteProvider {
  triggerCharacters?: string[];
  getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null>;
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/** The mention token at the cursor, if the cursor sits in one. */
export function mentionAtCursor(line: string, cursorCol: number): string | undefined {
  return AT_CURSOR.exec(line.slice(0, cursorCol))?.[1];
}

/** The agents whose names start with what follows `@subagent:`, built-ins last (roles files override). */
export function mentionItems(token: string, agents: readonly AgentDef[]): AutocompleteItem[] {
  const typed = token.slice(PREFIX.length).toLowerCase();
  return agents
    .filter((a) => a.name.toLowerCase().startsWith(typed))
    .map((a) => ({ value: `${PREFIX}${a.name}`, label: a.name, description: `${a.description}${a.source === "builtin" ? "" : ` (${a.source})`}` }));
}

/**
 * Pi's autocomplete, with `@subagent:` on top: in a mention, the discovered agents; anywhere else,
 * what pi would have suggested (its `@` file completion included).
 */
export function subagentAutocomplete(current: AutocompleteProvider, agents: () => readonly AgentDef[]): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@", ":"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.signal.aborted) return null;
      const token = mentionAtCursor(lines[cursorLine] ?? "", cursorCol);
      if (token !== undefined) {
        let items: AutocompleteItem[] = [];
        try {
          items = mentionItems(token, agents());
        } catch {
          // Unreadable agent files: nothing to offer.
        }
        return items.length ? { items, prefix: token } : null;
      }
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!prefix.startsWith(PREFIX) || !item.value.startsWith(PREFIX)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, Math.max(0, cursorCol - prefix.length));
      const after = line.slice(cursorCol);
      const next = [...lines];
      next[cursorLine] = `${before}${item.value} ${after}`;
      return { lines: next, cursorLine, cursorCol: before.length + item.value.length + 1 };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (mentionAtCursor(lines[cursorLine] ?? "", cursorCol) !== undefined) return false;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
    },
  };
}

/** The names mentioned in a prompt, in order, each once. */
export function mentionedNames(prompt: string): string[] {
  const names: string[] = [];
  for (const m of prompt.matchAll(MENTIONS)) {
    const name = m[1] as string;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * What the model is told about a prompt's mentions: the agent each names and how to delegate to it,
 * or that no such agent exists and which do. Undefined when the prompt mentions none.
 */
export function mentionGuidance(prompt: string, agents: readonly AgentDef[]): string | undefined {
  const names = mentionedNames(prompt);
  if (!names.length) return undefined;
  const known = new Map(agents.map((a) => [a.name.toLowerCase(), a] as const));
  const lines = [`The user's message mentions subagent roles with \`@subagent:<name>\`. These are agents the \`subagent\` tool can run (pass the name as \`agent\`); a mention is a request to delegate the relevant part of the task to that agent, not to answer as it.`];
  for (const name of names) {
    const agent = known.get(name.toLowerCase());
    if (agent) {
      const traits = [agent.tools ? `tools: ${agent.tools.join(", ")}` : undefined, agent.model ? `model: ${agent.model}` : undefined, agent.thinking ? `thinking: ${agent.thinking}` : undefined].filter(Boolean).join("; ");
      lines.push(`- @subagent:${name} -> subagent(agent: "${agent.name}"): ${agent.description}${traits ? ` (${traits})` : ""}`);
    } else {
      lines.push(`- @subagent:${name}: no agent of that name is defined. Ask the user, or use one that is: ${agents.map((a) => a.name).join(", ")}.`);
    }
  }
  lines.push("Use headless subagents through the `subagent` tool; give each a complete, self-contained task.");
  return lines.join("\n");
}
