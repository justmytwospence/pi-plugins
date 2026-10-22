// /mcp-code [server...|all]: sign in to OAuth MCP servers with the device authorization grant
// (RFC 8628) instead of a browser redirect to localhost, for pi sessions whose browser is on another
// machine (SSH, a phone). Looks and behaves like Pi's own `/mcp` sign-in screen. The tokens go into
// pi's MCP credential store, so the built-in client sends and refreshes them as if it had signed in.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { loadServers, type HttpServer } from "./config.ts";
import { DeviceFlowError, discover, pollForTokens, requestDeviceCode, type DeviceCode } from "./device.ts";
import { hasTokens, saveTokens } from "./store.ts";
import { DeviceLoginView } from "./ui.ts";

const COMMAND = "mcp-code";
const ALL = "\u0000all";

type Sign =
  | { state: "starting" }
  | { state: "waiting"; code: DeviceCode; expiresAt: number }
  | { state: "done"; refresh: boolean }
  | { state: "failed"; error: string }
  | { state: "cancelled" };

const authFile = () => join(getAgentDir(), "mcp-auth.json");

function usable(server: HttpServer): string | undefined {
  if (!server.clientId) return "no oauth.clientId";
  if (server.clientSecret) return "uses a client secret";
  return undefined;
}

function remaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function signIn(server: HttpServer, signal: AbortSignal, update: (sign: Sign) => void): Promise<void> {
  try {
    const discovery = await discover(server.url, { authServerMetadataUrl: server.authServerMetadataUrl, signal });
    const scope = server.scope ?? discovery.scopes?.join(" ");
    const code = await requestDeviceCode(discovery, { clientId: server.clientId!, scope }, { signal });
    update({ state: "waiting", code, expiresAt: Date.now() + code.expiresIn * 1000 });
    const tokens = await pollForTokens(discovery, code, { clientId: server.clientId! }, { signal });
    await saveTokens(authFile(), server.name, server.url, tokens);
    update({ state: "done", refresh: Boolean(tokens.refresh_token) });
  } catch (error) {
    if (error instanceof DeviceFlowError && error.code === "cancelled") update({ state: "cancelled" });
    else update({ state: "failed", error: (error as Error).message });
  }
}

/** Runs the sign-ins in the view; resolves to the names that signed in. */
async function runSignIns(view: DeviceLoginView, servers: HttpServer[]): Promise<string[]> {
  const { theme } = view;
  const signs = new Map<string, Sign>(servers.map((s) => [s.name, { state: "starting" }]));
  const controller = new AbortController();
  const single = servers.length === 1;
  const title = single ? `Sign in to ${servers[0]!.name}` : `Sign in to ${servers.length} servers`;
  const cancelHint = keyHint("tui.select.cancel", "cancel");

  const describe = (name: string, sign: Sign): Component[] => {
    const muted = (text: string) => new Text(theme.fg("muted", text), 1, 0);
    const heading = single ? [] : [new Text(theme.bold(name), 1, 0)];
    switch (sign.state) {
      case "starting":
        return [...heading, muted("Requesting a code…")];
      case "waiting": {
        const link = sign.code.verificationUriComplete ?? sign.code.verificationUri;
        return [
          ...heading,
          muted("Approve access on any device. Visit:"),
          new Text(theme.fg("accent", link), 1, 0),
          new Spacer(1),
          new Text(`${theme.fg("muted", "Code:")} ${theme.fg("accent", theme.bold(sign.code.userCode))}`, 1, 0),
          muted(`Waiting for approval… expires in ${remaining(sign.expiresAt - Date.now())}`),
        ];
      }
      case "done":
        return [...heading, new Text(theme.fg("success", `Signed in${sign.refresh ? "" : " (no refresh token)"}`), 1, 0)];
      case "failed":
        return [...heading, new Text(theme.fg("error", sign.error), 1, 0)];
      case "cancelled":
        return [...heading, muted("Cancelled")];
    }
  };

  return new Promise((resolve) => {
    let finished = false;
    const succeeded = () => [...signs].filter(([, s]) => s.state === "done").map(([n]) => n);
    const close = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      controller.abort();
      resolve(succeeded());
    };
    const render = () => {
      if (finished) return;
      const body: Component[] = [];
      for (const [name, sign] of signs) body.push(new Spacer(1), ...describe(name, sign));
      const settled = [...signs.values()].every((s) => s.state !== "starting" && s.state !== "waiting");
      if (settled && [...signs.values()].every((s) => s.state === "done")) {
        close();
        return;
      }
      view.screen(
        title,
        body,
        settled ? keyHint("tui.select.cancel", "close") : cancelHint,
        settled ? { "tui.select.cancel": close, "tui.select.confirm": close } : { "tui.select.cancel": close },
      );
    };
    const timer = setInterval(render, 1000);
    render();
    for (const server of servers) {
      void signIn(server, controller.signal, (sign) => {
        signs.set(server.name, sign);
        render();
      });
    }
  });
}

export default function mcpDeviceLogin(pi: ExtensionAPI) {
  const servers = (ctx: ExtensionCommandContext) =>
    loadServers({
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      registered: pi.getMcpServers().map((s) => ({ name: s.name, config: s.config as never })),
    });

  pi.registerCommand(COMMAND, {
    description: "Sign in to OAuth MCP servers with a device code (no localhost redirect)",
    getArgumentCompletions: (prefix) => {
      const words = prefix.trimStart().split(/\s+/);
      const last = words[words.length - 1] ?? "";
      const before = words.slice(0, -1).join(" ");
      const names = [...loadServers({ agentDir: getAgentDir(), cwd: process.cwd(), projectTrusted: false }).keys()];
      return [...names, ...(words.length === 1 ? ["all"] : [])]
        .filter((n) => n.startsWith(last) && !words.slice(0, -1).includes(n))
        .map((n) => ({ value: before ? `${before} ${n}` : n, label: n }));
    },
    handler: async (args, ctx) => {
      const available = servers(ctx);
      const words = args.trim().split(/\s+/).filter(Boolean);
      for (const name of words) {
        if (name !== "all" && !available.has(name)) {
          ctx.ui.notify(`No HTTP MCP server named "${name}"`, "error");
          return;
        }
      }
      const eligible = [...available.values()].filter((s) => !usable(s));

      const signedIn = await ctx.ui.custom<string[]>((tui, theme, keybindings, done) => {
        const view = new DeviceLoginView(tui, theme, keybindings);
        void (async () => {
          let chosen: HttpServer[];
          if (words.includes("all")) chosen = eligible;
          else if (words.length) chosen = words.map((n) => available.get(n)!);
          else {
            // Servers without a pre-registered public client cannot use the device grant (Pi signs in
            // to those with dynamic client registration), so they are left out rather than offered.
            const items: SelectItem[] = [];
            if (eligible.length > 1) items.push({ value: ALL, label: "All servers", description: `${eligible.length} servers` });
            for (const server of eligible) {
              const status = hasTokens(authFile(), server.name, server.url) ? "signed in" : "not signed in";
              items.push({ value: server.name, label: server.name, description: status });
            }
            if (!items.length) {
              ctx.ui.notify("No MCP server has an oauth.clientId, which device sign-in needs", "warning");
              return done([]);
            }
            const hidden = available.size - eligible.length;
            const details = `Sign in with a code you approve on any device.${hidden ? ` ${hidden} server${hidden === 1 ? "" : "s"} without oauth.clientId not shown.` : ""}`;
            const picked = await view.menu("MCP device sign-in", items, details);
            if (!picked) return done([]);
            chosen = picked === ALL ? eligible : [available.get(picked)!];
          }
          for (const server of chosen) {
            const problem = usable(server);
            if (problem) {
              ctx.ui.notify(`${server.name}: ${problem}; device sign-in needs a pre-registered public client`, "error");
              return done([]);
            }
          }
          if (!chosen.length) return done([]);
          done(await runSignIns(view, chosen));
        })().catch((error) => {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          done([]);
        });
        return view;
      });

      if (!signedIn?.length) return;
      // Pi reconnects a server waiting for sign-in when its tokens change, but not one that failed (on
      // a refused refresh, say), and extensions cannot reconnect a server. Reloading reconnects all.
      if (ctx.isIdle()) {
        ctx.ui.notify(`Signed in to ${signedIn.join(", ")}; reconnecting`, "info");
        await ctx.reload();
      } else {
        ctx.ui.notify(`Signed in to ${signedIn.join(", ")}; run /reload after this turn to reconnect`, "info");
      }
    },
  });
}
