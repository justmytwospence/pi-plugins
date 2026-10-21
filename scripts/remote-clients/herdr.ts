// herdr-web-ui's own reader over the rendered screens (../test-remote-clients.mjs). Run with bun:
// `bun herdr.ts <screens.json> <herdr-web-ui bundle dir>`. Prints one card (or null) per screen.
import { readFileSync } from "node:fs";
import path from "node:path";

const [screensFile, bundle] = process.argv.slice(2) as [string, string];
const { parseInteractivePrompt } = await import(path.join(bundle, "server/prompt.ts"));
const screens: { text: string }[] = JSON.parse(readFileSync(screensFile, "utf8"));
const cards = screens.map(({ text }) => {
  const card = parseInteractivePrompt("pi", text);
  if (card === null) return null;
  return { question: card.question, multi: card.multi_select === true, options: (card.options ?? []).map((o: { label?: string }) => o.label ?? String(o)) };
});
console.log(JSON.stringify(cards));
