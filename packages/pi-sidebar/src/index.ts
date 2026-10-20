// Sidebar: a live, read-only side chat beside a working Pi session, in the same Pi process.
//
// Ctrl+' opens Sidebar in half of Pi's fullscreen layout (main reflows into the other half) or moves
// focus between the two. Every Sidebar request is main's last provider request plus Sidebar's part,
// so main's prompt cache serves it; it never changes anything, and it asks before a request would
// re-read main's context uncached.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KEYS_ENV, parseKeys } from "./config.ts";
import { SidebarController } from "./controller.ts";

const COMMAND_HELP = [
  "/sidebar        open Sidebar, or hide it (its thread is kept)",
  "/sidebar new    start a fresh Sidebar thread",
  "/sidebar model  why Sidebar always uses main's model",
  "Ctrl+'          open Sidebar, or switch focus between main and Sidebar",
].join("\n");

const MODEL_NOTE =
  "Sidebar always uses main's model and thinking settings: a provider's prompt cache belongs to one model and one set of settings, so anything else would re-read main's whole context uncached on every question.";

export default function piSidebar(pi: ExtensionAPI) {
  const keys = parseKeys(process.env[KEYS_ENV]);
  const sidebar = new SidebarController(pi, keys);

  for (const key of keys) {
    pi.registerShortcut(key as never, {
      description: "Open Sidebar, or move focus to it (a read-only side chat beside this session)",
      handler: (ctx) => sidebar.openOrFocus(ctx),
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
      else if (sub === "new") {
        await sidebar.reset();
        sidebar.openOrFocus(ctx);
      } else if (!sub) sidebar.toggle(ctx);
      else ctx.ui.notify(`Unknown /sidebar argument "${sub}".\n${COMMAND_HELP}`, "warning");
    },
  });
}
