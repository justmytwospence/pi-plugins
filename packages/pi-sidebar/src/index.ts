// Sidebar: a live, read-only side chat in a Herdr pane beside a working Pi session.
//
// The same extension runs in both panes. In the main session (the host) it publishes main's last
// provider request and live status, and opens, parks or closes the Sidebar pane. In the Sidebar pane
// (started with PI_SIDEBAR_HOST pointing at the host's runtime directory) it builds every request
// from main's last one so main's prompt cache serves it, keeps the conversation read-only, and
// refuses to send when that would re-read main's context uncached without asking.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHost } from "./host.ts";
import { HOST_ENV, KEYS_ENV, parseKeys } from "./protocol.ts";
import { registerSide } from "./side.ts";

const COMMAND_HELP = [
  "/sidebar        open or hide Sidebar (in Sidebar: hide it)",
  "/sidebar new    start a fresh Sidebar thread for this session",
  "/sidebar model  why Sidebar always uses main's model",
].join("\n");

const MODEL_NOTE =
  "Sidebar always uses main's model and thinking settings: a provider's prompt cache belongs to one model and one set of settings, so anything else would re-read main's whole context uncached on every question.";

export default function piSidebar(pi: ExtensionAPI) {
  const hostDir = process.env[HOST_ENV];
  const side = hostDir ? registerSide(pi, hostDir) : undefined;
  const host = hostDir ? undefined : registerHost(pi);

  const run = async (ctx: ExtensionContext, mode: "toggle" | "new") => {
    if (side) {
      if (mode === "new") {
        ctx.ui.notify("Use /new here to start a fresh Sidebar thread.", "info");
        return;
      }
      await side.hide(ctx);
      return;
    }
    await host!.toggle(ctx, mode);
  };

  for (const key of parseKeys(process.env[KEYS_ENV])) {
    pi.registerShortcut(key as never, {
      description: "Open or hide Sidebar, a read-only side chat beside this session",
      handler: (ctx) => run(ctx, "toggle"),
    });
  }

  pi.registerCommand("sidebar", {
    description: "Open or hide Sidebar, a live read-only side chat beside this session (new | model | help)",
    getArgumentCompletions: (prefix: string) =>
      ["new", "model", "help"].filter((a) => a.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "help") ctx.ui.notify(COMMAND_HELP, "info");
      else if (sub === "model" || sub.startsWith("model ") || sub.startsWith("thinking")) ctx.ui.notify(MODEL_NOTE, "info");
      else if (sub === "new") await run(ctx, "new");
      else if (!sub) await run(ctx, "toggle");
      else ctx.ui.notify(`Unknown /sidebar argument "${sub}".\n${COMMAND_HELP}`, "warning");
    },
  });
}
