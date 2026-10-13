// A status chip for pi's built-in MCP extension, which sets no status itself:
// its connection state is only visible in the /mcp menu. This approximates
// "connected/configured" from public data, and yields when another extension
// takes over /mcp (pi-mcp-adapter and the like publish their own "mcp" status).
//
// - Connected: tools from `builtin:mcp` whose exposure is not hidden, counted
//   once per namespace. Tools outlive a dropped connection, a server with no
//   tools is invisible, and needs-auth, failed and connecting are not told
//   apart, so this is an approximation.
// - Configured: entries of mcp.json with `enabled !== false` (the project
//   file only when the project is trusted).
// Ported from pi-cc-extensions' mcp-chip (MIT, (c) minuque).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** The status key pi-mcp-adapter uses; when it is present, this chip stays out. */
export const MCP_STATUS_KEY = "mcp";
/** Source path of pi's built-in MCP extension. */
export const BUILTIN_MCP_SOURCE = "builtin:mcp";
const MCP_NAMESPACE_PREFIX = "mcp__";

export interface McpCount { connected: number; total: number }

interface ToolLike { exposure?: string; namespace?: { name?: string }; sourceInfo?: { path?: string } }
interface CommandLike { name?: string; sourceInfo?: { path?: string } }

/** pi treats `-` and `_` as the same server name (`mcpNamespace` only swaps `-` for `_`). */
export function normalizeMcpServerName(name: string): string {
  return name.trim().replace(/-/g, "_");
}

/** `mcp__<server>` to `<server>`; undefined for a namespace that is not MCP's. */
export function mcpNamespaceServer(namespace: string): string | undefined {
  if (!namespace.startsWith(MCP_NAMESPACE_PREFIX)) return undefined;
  return namespace.slice(MCP_NAMESPACE_PREFIX.length) || undefined;
}

/** Connected server names (one per namespace, normalized). */
export function connectedMcpServers(tools: readonly ToolLike[]): string[] {
  const fromBuiltin = new Set<string>(), fromNamespace = new Set<string>();
  for (const tool of tools) {
    if (tool?.exposure === "hidden") continue;
    const server = mcpNamespaceServer(String(tool?.namespace?.name ?? ""));
    if (!server) continue;
    const name = normalizeMcpServerName(server);
    if (tool.sourceInfo?.path === BUILTIN_MCP_SOURCE) fromBuiltin.add(name);
    else fromNamespace.add(name);
  }
  // Version drift fallback: when no source path matches, trust the namespace
  // (extensions that took over /mcp were excluded before this point).
  return [...(fromBuiltin.size > 0 ? fromBuiltin : fromNamespace)];
}

/** `connected / (connected U configured)`; undefined when both are empty. */
export function countMcp(connected: readonly string[], configured: readonly string[]): McpCount | undefined {
  const connectedNames = new Set(connected.map(normalizeMcpServerName).filter(Boolean));
  const configuredNames = new Set(configured.map(normalizeMcpServerName).filter(Boolean));
  const total = new Set([...connectedNames, ...configuredNames]).size;
  return total === 0 ? undefined : { connected: connectedNames.size, total };
}

/** `MCP 2/3` as text (no glyph). */
export function formatMcpChip(count: McpCount | undefined): string | undefined {
  return count ? `MCP ${count.connected}/${count.total}` : undefined;
}

/** Enabled server names in one mcp.json, cached by mtime; undefined when the file is missing or broken. */
export class McpConfigReader {
  private cache = new Map<string, { mtimeMs: number; names: string[] }>();

  async read(file: string): Promise<string[] | undefined> {
    try {
      const { mtimeMs } = await stat(file);
      const cached = this.cache.get(file);
      if (cached && cached.mtimeMs === mtimeMs) return cached.names;
      const parsed = JSON.parse(await readFile(file, "utf8")) as { mcpServers?: unknown };
      const servers = parsed?.mcpServers;
      const names: string[] = [];
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          if ((entry as { enabled?: unknown }).enabled === false) continue;
          names.push(name);
        }
      }
      this.cache.set(file, { mtimeMs, names });
      return names;
    } catch {
      this.cache.delete(file);
      return undefined;
    }
  }

  /** Enabled servers: the user file, plus the trusted project's (same names count once). */
  async configured(options: { agentDir: string; cwd: string; projectTrusted: boolean }): Promise<string[]> {
    const names = [...(await this.read(path.join(options.agentDir, "mcp.json")) ?? [])];
    if (options.projectTrusted) names.push(...(await this.read(path.join(options.cwd, ".pi", "mcp.json")) ?? []));
    return names;
  }
}

/** Whether every registered `/mcp` command is pi's built-in one; a takeover publishes its own chip. */
export function builtinMcpOwnsCommand(commands: readonly CommandLike[]): boolean {
  const mcp = commands.filter((command) => command?.name === MCP_STATUS_KEY);
  return mcp.length > 0 && mcp.every((command) => command?.sourceInfo?.path === BUILTIN_MCP_SOURCE);
}
