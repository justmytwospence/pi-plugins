// Reads HTTP MCP servers from pi's `mcp.json` files: user-level `<agentDir>/mcp.json`, then the
// project's `.pi/mcp.json` when the project is trusted (a project entry with a `url` replaces the
// user entry of the same name), plus servers registered by extensions.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HttpServer {
  name: string;
  url: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  authServerMetadataUrl?: string;
}

interface RawServer {
  url?: unknown;
  oauth?: { clientId?: unknown; clientSecret?: unknown; scope?: unknown; authServerMetadataUrl?: unknown };
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** `${VAR}` references, as pi resolves them in mcp.json. */
export function expandEnv(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return value?.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

function fromRaw(name: string, raw: RawServer): HttpServer | undefined {
  const url = str(raw?.url);
  if (!url) return undefined;
  return {
    name,
    url,
    clientId: expandEnv(str(raw.oauth?.clientId)),
    clientSecret: str(raw.oauth?.clientSecret),
    scope: str(raw.oauth?.scope),
    authServerMetadataUrl: str(raw.oauth?.authServerMetadataUrl),
  };
}

function readServers(file: string): Record<string, RawServer> {
  if (!existsSync(file)) return {};
  try {
    const text = readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
    const servers = JSON.parse(text)?.mcpServers;
    return servers && typeof servers === "object" ? servers : {};
  } catch {
    return {};
  }
}

export function loadServers(options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  registered?: { name: string; config: RawServer }[];
}): Map<string, HttpServer> {
  const result = new Map<string, HttpServer>();
  const add = (name: string, raw: RawServer) => {
    const server = fromRaw(name, raw);
    if (server) result.set(name, server);
  };
  for (const { name, config } of options.registered ?? []) add(name, config);
  for (const [name, raw] of Object.entries(readServers(join(options.agentDir, "mcp.json")))) add(name, raw);
  if (options.projectTrusted) {
    for (const [name, raw] of Object.entries(readServers(join(options.cwd, ".pi", "mcp.json")))) add(name, raw);
  }
  return result;
}
