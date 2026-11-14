import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Discovery,
  type FamiliesFile,
  type Tier,
  MODEL_FAMILIES_CHANGED,
  confirmFamily,
  describeTable,
  ignoreFamily,
  loadFamilyTable,
  markSeen,
  readFamiliesFile,
  writeFamiliesFile,
} from "./model-families.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const catalogOf = (ctx: ExtensionContext) => {
  try {
    return ctx.modelRegistry.getAll();
  } catch {
    return [];
  }
};
const label = (d: Discovery) => `${d.name} · ${d.route} · ${d.tiers.join(", ") || "unrouted"} (${d.basis})`;
const CHOICES: Record<string, Tier[]> = {
  fast: ["fast"],
  balanced: ["balanced"],
  "fast + balanced": ["fast", "balanced"],
  strong: ["strong"],
  premium: ["premium"],
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (process.env.PI_SUBAGENT || !ctx.hasUI) return;
    const { file } = readFamiliesFile();
    const table = loadFamilyTable(catalogOf(ctx));
    if (table.error) ctx.ui.notify(`model-families.json: ${table.error}; using built-in families.`, "warning");
    const fresh = table.discoveries.filter((d) => !file.seen?.[d.route]?.includes(d.family));
    if (!fresh.length) return;
    const names = fresh
      .map((d) => `${d.name} (${d.route}, ${d.tiers.length ? `provisionally ${d.tiers.join("/")}` : "unrouted"})`)
      .join(", ");
    ctx.ui.notify(`New model families: ${names}. /families to confirm.`, "info");
    try {
      writeFamiliesFile(markSeen(file, fresh));
    } catch (error) {
      ctx.ui.notify(`Could not record seen model families: ${message(error)}`, "warning");
    }
  });

  pi.registerCommand("families", {
    description: "Model families: confirm or ignore new families, list routes",
    getArgumentCompletions: (prefix: string) => ["list"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
    handler: async (args: string, ctx: ExtensionContext) => {
      const table = loadFamilyTable(catalogOf(ctx));
      if (args.trim() === "list" || !ctx.hasUI || !table.discoveries.length) {
        ctx.ui.notify(describeTable(table), "info");
        return;
      }
      const listAll = "List all routes";
      const picked = await ctx.ui.select("Model families", [...table.discoveries.map(label), listAll]);
      if (!picked) return;
      const discovery = table.discoveries.find((d) => label(d) === picked);
      if (!discovery) {
        ctx.ui.notify(describeTable(table), "info");
        return;
      }
      const confirm = `Confirm ${discovery.tiers.join(" + ")}`;
      const options = [...(discovery.tiers.length ? [confirm] : []), ...Object.keys(CHOICES), "Ignore"];
      const choice = await ctx.ui.select(`${discovery.name} on ${discovery.route}`, options);
      if (!choice) return;
      const route = table.routes.find((r) => r.id === discovery.route);
      const index = route?.families.findIndex((f) => f.id === discovery.family) ?? -1;
      const before = route?.families[index + 1]?.id;
      const { file } = readFamiliesFile();
      let next: FamiliesFile;
      let outcome: string;
      if (choice === "Ignore") {
        next = ignoreFamily(file, discovery.route, discovery.family);
        outcome = "ignored";
      } else {
        const tiers = choice === confirm ? discovery.tiers : CHOICES[choice]!;
        next = confirmFamily(file, discovery.route, { id: discovery.family, name: discovery.name, tiers, ...(before ? { before } : {}) });
        outcome = tiers.join(" + ");
      }
      try {
        writeFamiliesFile(next);
      } catch (error) {
        ctx.ui.notify(`Could not write model-families.json: ${message(error)}`, "error");
        return;
      }
      pi.events.emit(MODEL_FAMILIES_CHANGED, {});
      ctx.ui.notify(
        `${discovery.name} is now ${outcome} on ${discovery.route}. Subagent picks use it now; plan model pairs update after /reload.`,
        "info",
      );
    },
  });
}
