// /mcp-code <server>: sign in to an OAuth MCP server with the device authorization grant
// (RFC 8628) instead of a browser redirect to localhost, for pi sessions whose browser is on another
// machine (SSH, a phone). The tokens go into pi's own MCP credential store, so the built-in MCP
// client sends and refreshes them as if it had signed in itself.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadServers, type HttpServer } from "./config.ts";
import { DeviceFlowError, discover, pollForTokens, requestDeviceCode } from "./device.ts";
import { saveTokens } from "./store.ts";

const COMMAND = "mcp-code";
const WIDGET = "mcp-device-login";

export default function mcpDeviceLogin(pi: ExtensionAPI) {
  const running = new Map<string, AbortController>();

  const servers = (ctx: ExtensionCommandContext) =>
    loadServers({
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      registered: pi.getMcpServers().map((s) => ({ name: s.name, config: s.config as never })),
    });

  const render = (ctx: ExtensionCommandContext, lines: Map<string, string[]>) => {
    const all = [...lines.values()].flat();
    ctx.ui.setWidget(WIDGET, all.length ? all : undefined);
  };
  const widgetLines = new Map<string, string[]>();

  async function signIn(server: HttpServer, ctx: ExtensionCommandContext) {
    if (!server.clientId) {
      ctx.ui.notify(`${COMMAND}: ${server.name} has no oauth.clientId in mcp.json; the device grant needs a pre-registered client`, "error");
      return;
    }
    if (server.clientSecret) {
      ctx.ui.notify(`${COMMAND}: ${server.name} uses a client secret; only public clients are supported`, "error");
      return;
    }
    running.get(server.name)?.abort();
    const controller = new AbortController();
    running.set(server.name, controller);
    const { signal } = controller;
    const clear = () => {
      if (running.get(server.name) === controller) running.delete(server.name);
      widgetLines.delete(server.name);
      render(ctx, widgetLines);
    };
    try {
      const discovery = await discover(server.url, { authServerMetadataUrl: server.authServerMetadataUrl, signal });
      const scope = server.scope ?? discovery.scopes?.join(" ");
      const code = await requestDeviceCode(discovery, { clientId: server.clientId, scope }, { signal });
      const link = code.verificationUriComplete ?? code.verificationUri;
      widgetLines.set(server.name, [
        `MCP sign-in ${server.name}: open ${link}`,
        `  code ${code.userCode}  (expires in ${Math.round(code.expiresIn / 60)} min; /${COMMAND} cancel ${server.name})`,
      ]);
      render(ctx, widgetLines);
      ctx.ui.notify(`${server.name}: approve code ${code.userCode} at ${link}`, "info");
      const tokens = await pollForTokens(discovery, code, { clientId: server.clientId }, { signal });
      await saveTokens(join(getAgentDir(), "mcp-auth.json"), server.name, server.url, tokens);
      ctx.ui.notify(
        `${server.name}: signed in${tokens.refresh_token ? "" : " (no refresh token: sign in again when it expires)"}. Takes effect on the next turn; /mcp reconnects now.`,
        "info",
      );
    } catch (error) {
      if (error instanceof DeviceFlowError && error.code === "cancelled") {
        ctx.ui.notify(`${server.name}: device sign-in cancelled`, "info");
      } else {
        ctx.ui.notify(`${COMMAND} ${server.name}: ${(error as Error).message}`, "error");
      }
    } finally {
      clear();
    }
  }

  pi.registerCommand(COMMAND, {
    description: "Sign in to an OAuth MCP server with a device code (no localhost redirect)",
    getArgumentCompletions: (prefix) => {
      const words = prefix.trimStart().split(/\s+/);
      if (words[0] === "cancel" && words.length === 2) {
        return [...running.keys()].filter((n) => n.startsWith(words[1]!)).map((n) => ({ value: `cancel ${n}`, label: n }));
      }
      if (words.length > 1) return null;
      const names = [...loadServers({ agentDir: getAgentDir(), cwd: process.cwd(), projectTrusted: false }).keys()];
      return [...names, "cancel"].filter((n) => n.startsWith(words[0] ?? "")).map((n) => ({ value: n, label: n }));
    },
    handler: async (args, ctx) => {
      const [first, second] = args.trim().split(/\s+/).filter(Boolean);
      if (first === "cancel") {
        const targets = second ? [second] : [...running.keys()];
        if (!targets.length) ctx.ui.notify(`${COMMAND}: no sign-in is running`, "info");
        for (const name of targets) running.get(name)?.abort();
        return;
      }
      const available = servers(ctx);
      let name: string | undefined = first;
      if (!name) {
        const names = [...available.keys()];
        if (!names.length) {
          ctx.ui.notify(`${COMMAND}: no HTTP MCP servers configured`, "error");
          return;
        }
        name = await ctx.ui.select("Sign in to which MCP server with a device code?", names);
        if (!name) return;
      }
      const server = available.get(name);
      if (!server) {
        ctx.ui.notify(`${COMMAND}: no HTTP MCP server named ${name}`, "error");
        return;
      }
      // Poll in the background so the session stays usable while the code waits for approval.
      void signIn(server, ctx);
    },
  });

  pi.on("session_shutdown", () => {
    for (const controller of running.values()) controller.abort();
  });
}
