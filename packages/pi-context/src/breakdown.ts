// Counting and assembly for /context: which part of the context window each token belongs to, and the
// preview text for each part. Nothing here touches the terminal; index.ts draws the result.
//
// Ported from pi-cc-extensions (MIT, minuque) and reduced to the pieces the command needs.
import { estimateTokens, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

export type PartColor = "accent" | "success" | "warning" | "customMessageLabel" | "muted" | "dim" | "error";

export type ContextPart = { label: string; tokens: number; color: PartColor };

export type PreviewKey = "systemPrompt" | "memoryFiles" | "skills" | "tools" | "toolResults" | "contextFiles";

export type ContextBreakdown = {
  /** System prompt, Memory, Skills, Tools definition, Tool results, Context; in that order. */
  parts: ContextPart[];
  previews: Record<PreviewKey, string>;
};

/** The parts whose token count is exact (they are the request's system prompt and tool list). */
export const FIXED_PARTS = 4;

/** What /context reads from the session; narrowed so tests can hand in plain data. */
export type BreakdownInput = {
  systemPrompt: string;
  options: Partial<BuildSystemPromptOptions>;
  tools: Array<Pick<ToolInfo, "name" | "description" | "parameters">>;
  entries: SessionEntry[];
};

export type UsageInput = { tokens: number | null; percent: number | null } | undefined;

/** Characters / 4, the same heuristic pi's compaction uses. */
export function tokenEstimate(value: unknown): number {
  if (!value) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(0, Math.ceil(text.length / 4));
}

/** Tokens of a chunk only when it is actually embedded in the prompt, so a source file is not counted twice. */
export function embeddedTokens(prompt: string, chunk: string): number {
  if (!chunk || !prompt.includes(chunk)) return 0;
  return tokenEstimate(chunk);
}

/**
 * Scale the variable parts (after `fixedPrefix`) down proportionally so the total does not exceed
 * `target`. The fixed prefix is never changed; rounding error lands on the last variable part.
 */
export function capParts(parts: ContextPart[], target: number, fixedPrefix = 0): ContextPart[] {
  const fixed = parts.slice(0, fixedPrefix);
  const variable = parts.slice(fixedPrefix);
  const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
  const variableTarget = Math.max(0, target - fixedTokens);
  const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
  if (estimated <= variableTarget || estimated === 0) return parts;
  if (variableTarget === 0) return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];

  let previous = 0;
  let cumulative = 0;
  const capped = variable.map((part, index) => {
    cumulative += part.tokens;
    const next = index === variable.length - 1 ? variableTarget : Math.round((cumulative / estimated) * variableTarget);
    const tokens = next - previous;
    previous = next;
    return { ...part, tokens };
  });
  return [...fixed, ...capped];
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

/**
 * Pick the number of used tokens to show. Pi reports both a count and a percentage; some providers
 * return a bogus total, so when the two disagree the percentage (what the footer shows) wins, and when
 * both are far below what the content alone must cost, the content estimate wins.
 */
export function resolveUsedTokens(usage: UsageInput, estimated: number, contextWindow: number): number {
  const reported = usage?.tokens;
  const fromPercent =
    usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0
      ? Math.round((usage.percent / 100) * contextWindow)
      : undefined;
  let resolved = reported ?? fromPercent ?? estimated;
  if (reported !== null && reported !== undefined && fromPercent !== undefined) {
    const tolerance = Math.max(32, Math.round(contextWindow * 0.001));
    if (Math.abs(reported - fromPercent) > tolerance) resolved = fromPercent;
  }
  if (estimated > 0 && resolved < estimated * 0.25) return estimated;
  return resolved;
}

export function normalizePreviewText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value;
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/**
 * The skills section as pi rendered it into this prompt. Pi words the hint after whichever reader
 * tool is declared, so try each wording and keep the one the prompt contains.
 */
function embeddedSkillsText(systemPrompt: string, skills: BuildSystemPromptOptions["skills"]): string {
  const readers = ["read", "bash", "indirect"] as const;
  const candidates = readers.map((reader) => formatSkillsForPrompt(skills ?? [], reader).trim());
  return candidates.find((text) => text && systemPrompt.includes(text)) ?? candidates[0] ?? "";
}

/** Count and preview the three things a request carries: system prompt, tool definitions, messages. */
export function collectContextBreakdown(input: BreakdownInput): ContextBreakdown {
  const { systemPrompt, options, tools, entries } = input;
  const selectedTools = new Set(options.selectedTools ?? ["read", "bash", "edit", "write"]);
  for (const hidden of options.hiddenTools ?? []) selectedTools.delete(hidden);

  const memoryPreview: string[] = [];
  let memoryTokens = 0;
  for (const file of options.contextFiles ?? []) {
    memoryTokens += embeddedTokens(systemPrompt, file.content);
    memoryPreview.push(`## ${file.path}\n\n${previewValue(file.content)}`);
  }

  const skillsText = embeddedSkillsText(systemPrompt, options.skills);
  const skillsTokens = embeddedTokens(systemPrompt, skillsText);

  const toolDefinitionPreview: string[] = [];
  let toolDefinitionTokens = 0;
  for (const tool of tools) {
    if (!selectedTools.has(tool.name)) continue;
    const definition = { name: tool.name, description: tool.description, parameters: tool.parameters };
    toolDefinitionTokens += tokenEstimate(definition);
    toolDefinitionPreview.push(`## Definition: ${tool.name}\n\n${previewValue(definition)}`);
  }

  const toolResultPreview: string[] = [];
  const contextPreview: string[] = [];
  let toolResultTokens = 0;
  let contextTokens = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall") {
            contextTokens += tokenEstimate(block.name) + tokenEstimate(block.arguments);
            contextPreview.push(`## Assistant tool call: ${block.name}\n\n${previewValue(block.arguments)}`);
          } else if (block.type === "text") {
            contextTokens += tokenEstimate(block.text);
            contextPreview.push(`## Assistant\n\n${block.text}`);
          } else if (block.type === "thinking") {
            contextTokens += tokenEstimate(block.thinking);
            contextPreview.push(`## Assistant thinking\n\n${block.thinking}`);
          }
        }
      } else if (message.role === "toolResult") {
        toolResultTokens += estimateTokens(message);
        toolResultPreview.push(`## Result: ${message.toolName}\n\n${previewValue(message.content)}`);
      } else if (message.role === "bashExecution") {
        toolResultTokens += estimateTokens(message);
        toolResultPreview.push(
          `## Bash\n\nCommand:\n\n${previewValue(message.command)}\n\nOutput:\n\n${previewValue(message.output)}`,
        );
      } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
        contextTokens += estimateTokens(message);
        contextPreview.push(`## ${message.role}\n\n${message.summary}`);
      } else {
        contextTokens += estimateTokens(message);
        contextPreview.push(`## ${message.role}\n\n${previewValue(message.content)}`);
      }
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      contextTokens += tokenEstimate(entry.summary);
      contextPreview.push(`## ${entry.type === "compaction" ? "Compaction" : "Branch summary"}\n\n${entry.summary}`);
    } else if (entry.type === "custom_message") {
      contextTokens += tokenEstimate(entry.content);
      contextPreview.push(`## Custom: ${entry.customType}\n\n${previewValue(entry.content)}`);
    }
  }

  const systemTokens = Math.max(0, tokenEstimate(systemPrompt) - memoryTokens - skillsTokens);
  return {
    parts: [
      { label: "System prompt", tokens: systemTokens, color: "accent" },
      { label: "Memory", tokens: memoryTokens, color: "error" },
      { label: "Skills", tokens: skillsTokens, color: "warning" },
      { label: "Tools definition", tokens: toolDefinitionTokens, color: "success" },
      { label: "Tool results", tokens: toolResultTokens, color: "customMessageLabel" },
      { label: "Context", tokens: contextTokens, color: "warning" },
    ],
    previews: {
      systemPrompt: systemPrompt || "No system prompt.",
      memoryFiles: memoryPreview.join("\n\n") || "No memory files in context.",
      skills: skillsText || "No skills in context.",
      tools: toolDefinitionPreview.join("\n\n") || "No active tool definitions.",
      toolResults: toolResultPreview.join("\n\n") || "No tool results in the current context.",
      contextFiles: contextPreview.join("\n\n") || "No conversation context.",
    },
  };
}

export type ContextReport = {
  /** The breakdown parts, capped to the used total, then Other and Free space. */
  parts: ContextPart[];
  used: number;
  contextWindow: number;
};

/** Reconcile the estimated breakdown with the usage pi reports and add the Other and Free space rows. */
export function assembleReport(breakdown: ContextBreakdown, usage: UsageInput, contextWindow: number): ContextReport {
  const estimated = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
  const fixedTokens = breakdown.parts.slice(0, FIXED_PARTS).reduce((sum, part) => sum + part.tokens, 0);
  const used = Math.max(resolveUsedTokens(usage, estimated, contextWindow), fixedTokens);
  const parts = capParts(breakdown.parts, used, FIXED_PARTS);
  const attributed = parts.reduce((sum, part) => sum + part.tokens, 0);
  const other = Math.max(0, used - attributed);
  const free = Math.max(0, contextWindow - used);
  return {
    parts: [...parts, { label: "Other", tokens: other, color: "muted" }, { label: "Free space", tokens: free, color: "dim" }],
    used,
    contextWindow,
  };
}

/** Plain-text report for non-TUI modes. */
export function formatReport(report: ContextReport): string {
  const percent = report.contextWindow > 0 ? (report.used / report.contextWindow) * 100 : 0;
  const header = `Context: ${formatTokens(report.used)} / ${formatTokens(report.contextWindow)} tokens (${percent.toFixed(1)}%)`;
  return [header, ...report.parts.map((part) => `${part.label}: ${formatTokens(part.tokens)} tokens`)].join("\n");
}
