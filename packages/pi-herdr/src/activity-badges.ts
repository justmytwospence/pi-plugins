import { Activity, type ActivityChannel, type HoldEvent } from "./core/activity.ts";

// Keep the shared hold/release protocol unchanged; only Pi's sidebar presentation
// is compact. Normalize before grouping so arbitrary task names cannot add badges.
export class ActivityBadges extends Activity {
  override apply(channel: ActivityChannel, event: HoldEvent | undefined): void {
    if (!event?.active) { super.apply(channel, event); return; }
    const label = event.label?.trim() ?? "";
    const agents = /^subagents \((\d+)\)$/.exec(label);
    const icon = agents ? "⑂" : label.startsWith("child ") ? "↳" : channel === "herdr:working" ? "≡" : "⌘";
    const parsed = agents ? Number(agents[1]) : 1;
    const count = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
    super.apply(channel, { ...event, label: `${icon} ${count}` });
  }

  override token(): string | undefined {
    const token = super.token();
    if (!token) return undefined;
    const counts = new Map<string, number>();
    for (const badge of token.split(" · ")) {
      const [, icon, count, repeats] = /^(\S+) (\d+)(?: ×(\d+))?$/.exec(badge)!;
      counts.set(icon, (counts.get(icon) ?? 0) + Number(count) * Number(repeats ?? 1));
    }
    return [...counts].map(([icon, count]) => `${icon} ${count}`).join(" · ");
  }
}
