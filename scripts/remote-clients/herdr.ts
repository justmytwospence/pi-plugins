// herdr-web-ui's own reader over the rendered screens (../test-remote-clients.mjs). Run with bun:
// `bun herdr.ts <screens.json> <herdr-web-ui bundle dir>`. Prints one card (or null) per screen.
import { readFileSync } from "node:fs";
import path from "node:path";

const [screensFile, bundle] = process.argv.slice(2) as [string, string];
const { parseInteractivePrompt, answerKeys } = await import(path.join(bundle, "server/prompt.ts"));
const screens: { text: string; answer?: { option_index?: number; custom_text?: string } }[] = JSON.parse(readFileSync(screensFile, "utf8"));
const cards = screens.map(({ text, answer }) => {
  const card = parseInteractivePrompt("pi", text);
  if (card === null) {
    if (answer) throw new Error("The requested answer has no parsed card.");
    return null;
  }
  const answerSteps = answer ? answerKeys(card, answer) : undefined;
  return {
    question: card.question,
    multi: card.multi_select === true,
    options: (card.options ?? []).map((o: { label?: string }) => o.label ?? String(o)),
    ...(answerSteps ? { answerSteps } : {}),
  };
});
console.log(JSON.stringify(cards));
